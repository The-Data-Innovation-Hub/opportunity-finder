import {useQuery} from '@tanstack/react-query'
import {api, type Responses} from './api'

export const useMe = ({enabled = true}: {enabled?: boolean} = {}) => useQuery({queryKey: ['me'], queryFn: () => api.get<Responses['GET /me']>('/me'), enabled})
