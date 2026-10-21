import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { startDisplayScale } from './displayScale'
import { initThoughtSpot } from './thoughtspot'

initThoughtSpot()

startDisplayScale()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
