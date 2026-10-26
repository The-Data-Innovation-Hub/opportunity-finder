import {StrictMode} from 'react'
import {createRoot} from 'react-dom/client'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {RouterProvider} from '@tanstack/react-router'
import {router} from './router'
import {ApiError} from './api'
import './styles.css'

const queryClient = new QueryClient({defaultOptions: {queries: {
	staleTime: 30_000,
	// A 4xx will not fix itself on retry.
	retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
}}})

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	</StrictMode>,
)
