import app from '$/routes/app'
import { LatitudeErrorCodes } from '@latitude-data/constants/errors'
import {
  Commit,
  Project,
  ProviderApiKey,
  User,
  Workspace,
} from '@latitude-data/core/browser'
import { unsafelyGetFirstApiKeyByWorkspaceId } from '@latitude-data/core/data-access'
import {
  createDocumentVersion,
  createDraft,
  createProject,
  helpers,
} from '@latitude-data/core/factories'
import {
  DocumentVersionsRepository,
  ProviderApiKeysRepository,
} from '@latitude-data/core/repositories'
import { mergeCommit } from '@latitude-data/core/services/commits/merge'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  queues: {
    defaultQueue: {
      jobs: {},
    },
  },
}))

vi.mock('$/jobs', () => ({
  queues: mocks.queues,
}))

describe('POST /get-or-create', () => {
  describe('when unauthorized', () => {
    beforeEach(async () => {
      vi.clearAllMocks()
    })

    it('fails', async () => {
      const projectId = 'fake-project-id'
      const commitUuid = 'fake-commit-uuid'

      const response = await app.request(
        `/api/v3/projects/${projectId}/versions/${commitUuid}/documents/get-or-create`,
      )

      expect(response.status).toBe(401)
    })
  })

  describe('when authorized', () => {
    let route: string
    let headers: Record<string, string>
    let workspace: Workspace
    let project: Project
    let user: User
    let commit: Commit
    let providers: ProviderApiKey[]

    beforeEach(async () => {
      vi.clearAllMocks()

      const {
        workspace: w,
        project: p,
        user: u,
        providers: ps,
      } = await createProject()
      workspace = w
      project = p
      user = u
      const { commit: c } = await createDraft({ project, user })
      commit = c
      providers = ps

      const apikey = await unsafelyGetFirstApiKeyByWorkspaceId({
        workspaceId: workspace.id,
      }).then((r) => r.unwrap())

      route = `/api/v3/projects/${project.id}/versions/${commit.uuid}/documents/get-or-create`
      headers = {
        Authorization: `Bearer ${apikey.token}`,
        'Content-Type': 'application/json',
      }
    })

    it('succeeds when getting an existing document', async () => {
      let { documentVersion: document } = await createDocumentVersion({
        workspace,
        user,
        commit,
        path: 'fake-path',
        content: helpers.createPrompt({
          provider: providers[0]!.name,
          model: 'fake-model',
        }),
      })

      const response = await app.request(route, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: document.path,
        }),
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        versionUuid: commit.uuid,
        uuid: document.documentUuid,
        path: document.path,
        content: document.content,
        contentHash: undefined,
        config: {
          provider: providers[0]!.name,
          model: 'fake-model',
        },
        parameters: {},
        provider: providers[0]!.provider,
      })
    })

    it('succeeds when creating a new document', async () => {
      const docsScope = new DocumentVersionsRepository(workspace.id)
      const document = await docsScope.getDocumentByPath({
        commit,
        path: 'fake-path',
      })
      expect(document.error!.name).toEqual(LatitudeErrorCodes.NotFoundError)

      const prompt = helpers.createPrompt({
        provider: providers[0]!.name,
        model: 'fake-model',
      })
      const response = await app.request(route, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: 'fake-path',
          prompt: prompt,
        }),
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        versionUuid: commit.uuid,
        uuid: expect.any(String),
        path: 'fake-path',
        content: prompt,
        contentHash: undefined,
        config: {
          provider: providers[0]!.name,
          model: 'fake-model',
        },
        parameters: {},
        provider: providers[0]!.provider,
      })
    })

    it('fails when creating a document on a published version', async () => {
      const providersScope = new ProviderApiKeysRepository(workspace.id)
      const provider = await providersScope.findFirst().then((r) => r.unwrap())

      await createDocumentVersion({
        workspace,
        user,
        commit,
        path: 'some-document',
        content: helpers.createPrompt({
          provider: provider!.name,
          model: 'some-model',
        }),
      })
      commit = await mergeCommit(commit).then((r) => r.unwrap())

      const docsScope = new DocumentVersionsRepository(workspace.id)
      const document = await docsScope.getDocumentByPath({
        commit,
        path: 'fake-path',
      })
      expect(document.error!.name).toEqual(LatitudeErrorCodes.NotFoundError)

      const response = await app.request(route, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: 'fake-path',
          prompt: helpers.createPrompt({
            provider: 'fake-provider',
            model: 'fake-model',
          }),
        }),
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        name: LatitudeErrorCodes.BadRequestError,
        errorCode: LatitudeErrorCodes.BadRequestError,
        message: 'Cannot modify a merged commit',
        details: {},
      })
    })
  })
})
