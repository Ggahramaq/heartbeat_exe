import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/fusion-pixel-12px-monospaced-sc'
import './styles.css'
import { SurvivePage } from './survive-page.jsx'
import { TalkPage } from './talk-page.jsx'
import { TerminalPage } from './terminal-page.jsx'
import { WalletPage } from './wallet-page.jsx'
import { SyncPage } from './sync-page.jsx'

function AppRouter() {
  const [path, setPath] = useState(window.location.pathname)
  useEffect(() => {
    const update = () => setPath(window.location.pathname)
    window.addEventListener('popstate', update)
    return () => window.removeEventListener('popstate', update)
  }, [])
  if (path === '/talk-to-me') return <TalkPage />
  if (path === '/terminal' || path === '/memory') return <TerminalPage />
  if (path === '/wallet') return <WalletPage />
  if (path === '/sync') return <SyncPage />
  return <SurvivePage />
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AppRouter />
  </StrictMode>,
)
