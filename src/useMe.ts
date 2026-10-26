import {useQuery} from '@tanstack/react-query'
import {api, type Me} from './api'

export const useMe = ({enabled = true}: {enabled?: boolean} = {}) => useQuery({queryKey: ['me'], queryFn: () => api.get<Me>('/me'), enabled})
