import { ChainStepResponse, StreamType } from '@latitude-data/constants'
import { ChainError, RunErrorCodes } from '@latitude-data/constants/errors'
import { LatitudePromptConfig } from '@latitude-data/constants/latitudePromptSchema'
import { Adapters, Chain, Chain as PromptlChain, scan } from 'promptl-ai'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import {
  Commit,
  EvaluationType,
  EvaluationV2,
  LLM_EVALUATION_PROMPT_PARAMETERS,
  LlmEvaluationMetric,
  LogSources,
  ProviderApiKey,
  Workspace,
} from '../../../browser'
import { database } from '../../../client'
import { Result } from '../../../lib/Result'
import { updatePromptMetadata } from '../../../lib/updatePromptMetadata'
import { ProviderLogsRepository } from '../../../repositories'
import { BACKGROUND, telemetry } from '../../../telemetry'
import { runChain } from '../../chains/run'
import { parsePrompt } from '../../documents/parse'

export function promptTask() {
  return `
<user>
  Based on the given instructions, evaluate the assistant response:
  \`\`\`
  {{ actualOutput }}
  \`\`\`

  For context, here is the full conversation:
  \`\`\`
  {{ conversation }}
  \`\`\`

  {{ if toolCalls?.length }}
    Also, here are the tool calls that the assistant requested:
    \`\`\`
    {{ toolCalls }}
    \`\`\`
  {{ else }}
    Also, the assistant did not request any tool calls.
  {{ endif }}

  Finally, here is some additional metadata about the conversation. It may or may not be relevant for the evaluation.
  - Cost: {{ cost }} cents.
  - Tokens: {{ tokens }} tokens.
  - Duration: {{ duration }} seconds.
</user>'
`.trim()
}

export async function buildLlmEvaluationRunFunction<
  M extends LlmEvaluationMetric,
>({
  resultUuid,
  workspace,
  providers,
  evaluation,
  prompt,
  parameters,
  schema,
}: {
  resultUuid: string
  workspace: Workspace
  providers: Map<string, ProviderApiKey>
  evaluation: EvaluationV2<EvaluationType.Llm, M>
  prompt: string
  parameters?: Record<string, unknown>
  schema?: z.ZodSchema
}) {
  let promptConfig: LatitudePromptConfig
  let promptChain: PromptlChain
  try {
    if (schema) {
      prompt = updatePromptMetadata(prompt, {
        schema: zodToJsonSchema(schema, { target: 'openAi' }),
      })
    }

    const ast = await parsePrompt(prompt).then((r) => r.unwrap())
    const result = await scan({
      prompt,
      serialized: ast,
      withParameters: LLM_EVALUATION_PROMPT_PARAMETERS as unknown as string[],
    })
    if (result.errors.length > 0) {
      return Result.error(
        new ChainError({
          code: RunErrorCodes.ChainCompileError,
          message: result.errors.join('\n'),
        }),
      )
    }

    promptConfig = result.config as LatitudePromptConfig
    promptChain = new Chain({
      serialized: { ast },
      prompt: prompt,
      parameters: parameters,
      includeSourceMap: true,
      adapter: Adapters.default,
    })
  } catch (error) {
    if (error instanceof ChainError) return Result.error(error)
    return Result.error(
      new ChainError({
        code: RunErrorCodes.ChainCompileError,
        message: (error as Error).message,
      }),
    )
  }

  const runArgs = {
    generateUUID: () => resultUuid,
    chain: promptChain,
    source: LogSources.Evaluation,
    promptSource: { ...evaluation, version: 'v2' as const },
    providersMap: providers,
    workspace: workspace,
  }

  return Result.ok({ promptChain, promptConfig, runArgs })
}

export async function runPrompt<
  M extends LlmEvaluationMetric,
  S extends z.ZodSchema = z.ZodAny,
>(
  {
    prompt,
    parameters,
    schema,
    resultUuid,
    evaluation,
    providers,
    commit,
    workspace,
  }: {
    prompt: string
    parameters?: Record<string, unknown>
    schema?: S
    resultUuid: string
    evaluation: EvaluationV2<EvaluationType.Llm, M>
    providers: Map<string, ProviderApiKey>
    commit: Commit
    workspace: Workspace
  },
  db = database,
) {
  const { promptChain, runArgs } = await buildLlmEvaluationRunFunction({
    resultUuid,
    workspace,
    providers,
    evaluation,
    prompt,
    parameters,
    schema,
  }).then((r) => r.unwrap())

  const $prompt = telemetry.prompt(BACKGROUND({ workspaceId: workspace.id }), {
    logUuid: resultUuid,
    versionUuid: commit.uuid,
    promptUuid: evaluation.uuid,
    template: prompt,
    parameters: parameters,
    _internal: { source: runArgs.source },
  })

  let response
  try {
    const result = runChain({ context: $prompt.context, ...runArgs })
    const error = await result.error
    if (error) throw error

    response = await result.response

    $prompt.end()
  } catch (error) {
    $prompt.fail(error as Error)

    if (error instanceof ChainError) throw error

    const e = error as Error
    throw new ChainError({
      code: RunErrorCodes.Unknown,
      message: e.message,
      details: {
        stack: e.stack || '',
      },
    })
  }

  if (!promptChain.completed) {
    throw new ChainError({
      code: RunErrorCodes.AIRunError,
      message: 'Evaluation conversation is not completed',
    })
  }

  if (!response?.providerLog?.documentLogUuid) {
    throw new ChainError({
      code: RunErrorCodes.AIRunError,
      message: 'Evaluation conversation log not created',
    })
  }

  let verdict: S extends z.ZodSchema ? z.infer<S> : unknown
  verdict = parseVerdict(response)

  if (schema) {
    const result = schema.safeParse(verdict)
    if (result.error) {
      throw new ChainError({
        code: RunErrorCodes.InvalidResponseFormatError,
        message: result.error.message,
      })
    }

    verdict = result.data
  }

  const repository = new ProviderLogsRepository(workspace.id, db)
  const stats = await repository
    .statsByDocumentLogUuid(response.providerLog.documentLogUuid)
    .then((r) => r.unwrap())

  return { response, stats, verdict }
}

function parseVerdict(response: ChainStepResponse<StreamType>) {
  if (response.streamType !== 'object') {
    throw new ChainError({
      code: RunErrorCodes.InvalidResponseFormatError,
      message: 'Evaluation conversation response is not an object',
    })
  }

  return response.object
}
