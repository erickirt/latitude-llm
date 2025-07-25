import useFetcher from '$/hooks/useFetcher'
import { API_ROUTES } from '$/services/routes/api'
import useSWR, { SWRConfiguration } from 'swr'
import { useMemo } from 'react'

export default function useFeatureWorkspaces(
  featureId: number | null,
  opts?: SWRConfiguration,
) {
  const key = featureId ? `api/admin/features/${featureId}/workspaces` : null
  const fetcher = useFetcher<number[]>(
    featureId ? API_ROUTES.admin.features.workspaces(featureId) : '',
  )
  const { data = [], ...rest } = useSWR<number[]>(key, fetcher, opts)

  return useMemo(
    () => ({
      data,
      ...rest,
    }),
    [data, rest],
  )
}
