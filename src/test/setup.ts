import '@testing-library/jest-dom/vitest'
import {afterEach, vi} from 'vitest'
import {cleanup} from '@testing-library/react'

// jsdom does not implement scrolling; the router scrolls on navigation.
window.scrollTo = () => {}

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})
