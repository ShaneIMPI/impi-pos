import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/impi-pos/', // must match your GitHub repo name for GitHub Pages
  plugins: [react()],
})
