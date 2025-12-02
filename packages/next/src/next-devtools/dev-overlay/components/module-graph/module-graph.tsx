import { useState, useEffect, useCallback, useMemo } from 'react'
import './module-graph.css'

interface ModuleGraphModule {
  source: string
  type: 'userland' | 'external'
  size: number
  depth: number
  layer: string | null
  imports: string[]
  version?: string
  ident?: string
}

interface ModuleGraphData {
  route: string
  routeType: string
  summary: {
    totalModules: number
    userlandModules: number
    externalPackages: number
    totalSize: number
  }
  modules: ModuleGraphModule[]
  error?: string
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="currentColor"
      style={{
        transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
        transition: 'transform 0.15s ease',
      }}
    >
      <path
        d="M4.5 2.5L8 6L4.5 9.5"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
      />
    </svg>
  )
}

function ModuleItem({
  module,
  allModules,
  expandedModules,
  toggleModule,
  depth = 0,
}: {
  module: ModuleGraphModule
  allModules: Map<string, ModuleGraphModule>
  expandedModules: Set<string>
  toggleModule: (source: string) => void
  depth?: number
}) {
  const hasImports = module.imports.length > 0
  const isExpanded = expandedModules.has(module.source)

  return (
    <div className="module-graph-item" data-depth={depth}>
      <div
        className={`module-graph-item-row ${hasImports ? 'module-graph-item-expandable' : ''}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={hasImports ? () => toggleModule(module.source) : undefined}
      >
        <span className="module-graph-item-chevron">
          {hasImports && <ChevronIcon expanded={isExpanded} />}
        </span>
        <span
          className="module-graph-item-name"
          title={module.ident || module.source}
        >
          {module.source}
        </span>
        <span className="module-graph-item-meta">
          {module.layer && (
            <span
              className={`module-graph-item-layer module-graph-layer-${module.layer}`}
            >
              {module.layer}
            </span>
          )}
          <span className="module-graph-item-size">
            {formatBytes(module.size)}
          </span>
        </span>
      </div>
      {isExpanded && hasImports && (
        <div className="module-graph-item-children">
          {module.imports.map((importPath) => {
            const importedModule = allModules.get(importPath)
            if (!importedModule) {
              return (
                <div
                  key={importPath}
                  className="module-graph-item-row module-graph-item-missing"
                  style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
                >
                  <span className="module-graph-item-chevron" />
                  <span className="module-graph-item-name">{importPath}</span>
                </div>
              )
            }
            return (
              <ModuleItem
                key={importPath}
                module={importedModule}
                allModules={allModules}
                expandedModules={expandedModules}
                toggleModule={toggleModule}
                depth={depth + 1}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

function getRouteFromPage(page: string): string | null {
  // Convert page path to route format for Turbopack entrypoints
  // e.g., / -> /page, /dashboard -> /dashboard/page
  let pagePath = page

  // Fallback to window pathname if page is empty
  if (!pagePath && typeof window !== 'undefined') {
    pagePath = window.location.pathname
  }

  if (!pagePath) return null
  if (pagePath === '/') return '/page'
  // Remove trailing slash if present
  pagePath = pagePath.replace(/\/$/, '')
  return `${pagePath}/page`
}

interface FetchResult {
  route: string
  data: ModuleGraphData | null
  error: string | null
}

export function ModuleGraph({ page }: { page: string }) {
  const [result, setResult] = useState<FetchResult | null>(null)
  const [expandedModules, setExpandedModules] = useState<Set<string>>(new Set())

  // Derive route from page prop directly
  const route = useMemo(() => getRouteFromPage(page), [page])

  // Derive loading/data/error from result - loading when route doesn't match
  const loading = !result || result.route !== route
  const data = result?.route === route ? result.data : null
  const error = result?.route === route ? result.error : null

  useEffect(() => {
    if (!route) {
      return
    }

    let cancelled = false
    const basePath = process.env.__NEXT_ROUTER_BASEPATH || ''
    fetch(
      `${basePath}/__nextjs_module_graph?route=${encodeURIComponent(route)}`
    )
      .then((res) => res.json())
      .then((fetchResult) => {
        if (cancelled) return
        if (fetchResult.error) {
          // Show available routes if route not found
          let errorMsg = fetchResult.error
          if (fetchResult.availableRoutes?.length > 0) {
            errorMsg += `\n\nAvailable routes: ${fetchResult.availableRoutes.slice(0, 5).join(', ')}`
          }
          setResult({ route, data: null, error: errorMsg })
        } else {
          setResult({ route, data: fetchResult, error: null })
        }
      })
      .catch((err) => {
        if (cancelled) return
        setResult({ route, data: null, error: err.message })
      })

    return () => {
      cancelled = true
    }
  }, [route])

  const toggleModule = useCallback((source: string) => {
    setExpandedModules((prev) => {
      const next = new Set(prev)
      if (next.has(source)) {
        next.delete(source)
      } else {
        next.add(source)
      }
      return next
    })
  }, [])

  const allModulesMap = useMemo(() => {
    if (!data) return new Map<string, ModuleGraphModule>()
    return new Map(data.modules.map((m) => [m.source, m]))
  }, [data])

  // Get root modules (depth 0 or not imported by anything in userland)
  const rootModules = useMemo(() => {
    if (!data) return []
    const importedModules = new Set<string>()
    for (const m of data.modules) {
      if (m.type === 'userland') {
        for (const imp of m.imports) {
          importedModules.add(imp)
        }
      }
    }
    // Root modules are userland modules that aren't imported by other userland modules
    return data.modules.filter(
      (m) => m.type === 'userland' && !importedModules.has(m.source)
    )
  }, [data])

  // External packages shown separately
  const externalModules = useMemo(() => {
    if (!data) return []
    return data.modules.filter((m) => m.type === 'external')
  }, [data])

  if (!route) {
    return (
      <div className="module-graph-container">
        <div className="module-graph-error">No route available</div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="module-graph-container">
        <div className="module-graph-loading">
          Loading module graph for {route}...
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="module-graph-container">
        <div className="module-graph-error">
          <div>Route: {route}</div>
          <div>{error}</div>
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="module-graph-container">
        <div className="module-graph-empty">No module graph data available</div>
      </div>
    )
  }

  return (
    <div className="module-graph-container">
      <div className="module-graph-header">
        <div className="module-graph-route">{data.route}</div>
      </div>

      <div className="module-graph-content">
        {rootModules.length > 0 && (
          <div className="module-graph-section">
            <div className="module-graph-section-title">Files</div>
            {rootModules.map((module) => (
              <ModuleItem
                key={module.source}
                module={module}
                allModules={allModulesMap}
                expandedModules={expandedModules}
                toggleModule={toggleModule}
              />
            ))}
          </div>
        )}

        {externalModules.length > 0 && (
          <div className="module-graph-section">
            <div className="module-graph-section-title">Packages</div>
            {externalModules.map((module) => (
              <ModuleItem
                key={module.source}
                module={module}
                allModules={allModulesMap}
                expandedModules={expandedModules}
                toggleModule={toggleModule}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
