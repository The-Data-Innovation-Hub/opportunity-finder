import {defineConfig} from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// In development the API runs on :3001 and is proxied, so the session cookie
// is same-origin exactly as it is in Azure, where the API serves this build.
export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {port: 5173, proxy: {'/api': 'http://localhost:3001', '/dev-blobs': 'http://localhost:3001'}},
	build: {outDir: 'dist', sourcemap: false},
	test: {environment: 'jsdom', setupFiles: ['src/test/setup.ts'], include: ['src/**/*.test.{ts,tsx}']},
})
