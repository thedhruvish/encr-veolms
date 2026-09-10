import { HeadContent, Scripts, createRootRoute, Outlet } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { AuthProvider } from '../lib/auth-context'
import { Header } from '../components/Header'
import { useEffect } from 'react'

import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'VeoLMS - JWT Auth',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),
  component: RootComponent,
  shellComponent: RootDocument,
})

/** Disables right-click context menu and common DevTools keyboard shortcuts. */
function useSecurityGuard() {
  useEffect(() => {
    // Disable right-click context menu
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
    }

    // Block DevTools keyboard shortcuts
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key

      // F12
      if (key === 'F12') {
        e.preventDefault()
        return
      }

      // Ctrl/Cmd + Shift + I  (Elements / Sources)
      // Ctrl/Cmd + Shift + J  (Console)
      // Ctrl/Cmd + Shift + C  (Inspector)
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        ['I', 'J', 'C', 'i', 'j', 'c'].includes(key)
      ) {
        e.preventDefault()
        return
      }

      // Ctrl/Cmd + U  (View Source)
      if ((e.ctrlKey || e.metaKey) && (key === 'U' || key === 'u')) {
        e.preventDefault()
        return
      }
    }

    document.addEventListener('contextmenu', handleContextMenu)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('contextmenu', handleContextMenu)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [])
}

function RootComponent() {
  useSecurityGuard()

  return (
    <AuthProvider>
      <div className="min-h-screen bg-black text-white flex flex-col antialiased selection:bg-zinc-800 selection:text-white">
        <Header />
        <main className="flex-1 flex flex-col">
          <Outlet />
        </main>
      </div>
    </AuthProvider>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark bg-black">
      <head>
        <HeadContent />
      </head>
      <body className="bg-black text-white min-h-screen">
        {children}
        <TanStackDevtools
          config={{
            position: 'bottom-right',
          }}
          plugins={[
            {
              name: 'Tanstack Router',
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}
