import { useState, useEffect, useCallback, useMemo } from 'react'
import './module-graph.css'

interface ModuleGraphModule {
  source: string
  type: 'userland' | 'external'
  size: number
  depth: number
  layers: string[]
  imports: string[]
}

interface ModuleGraphData {
  route: string
  routeType: string
  layers: string[]
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
      <path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
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
  const isExternal = module.type === 'external'

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
          className={`module-graph-item-name ${isExternal ? 'module-graph-item-external' : 'module-graph-item-userland'}`}
          title={module.source}
        >
          {module.source}
        </span>
        <span className="module-graph-item-meta">
          {module.layers.map((layer) => (
            <span key={layer} className="module-graph-item-layer">
              {layer}
            </span>
          ))}
          <span className="module-graph-item-size">{formatBytes(module.size)}</span>
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

export function ModuleGraph({ page }: { page: string }) {
  const [data, setData] = useState<ModuleGraphData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedModules, setExpandedModules] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<'all' | 'userland' | 'external'>('all')
  const [route, setRoute] = useState<string | null>(() => getRouteFromPage(page))

  // Update route when page changes or on mount
  useEffect(() => {
    const newRoute = getRouteFromPage(page)
    if (newRoute !== route) {
      setRoute(newRoute)
    }
  }, [page, route])

  useEffect(() => {
    if (!route) {
      setLoading(false)
      setError('No route available')
      return
    }

    setLoading(true)
    setError(null)
    setData(null)

    const basePath = process.env.__NEXT_ROUTER_BASEPATH || ''
    fetch(`${basePath}/__nextjs_module_graph?route=${encodeURIComponent(route)}`)
      .then((res) => res.json())
      .then((result) => {
        if (result.error) {
          // Show available routes if route not found
          let errorMsg = result.error
          if (result.availableRoutes?.length > 0) {
            errorMsg += `\n\nAvailable routes: ${result.availableRoutes.slice(0, 5).join(', ')}`
          }
          setError(errorMsg)
        } else {
          setData(result)
        }
        setLoading(false)
      })
      .catch((err) => {
        setError(err.message)
        setLoading(false)
      })
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

  const filteredModules = useMemo(() => {
    if (!data) return []
    if (filter === 'all') return data.modules
    return data.modules.filter((m) => m.type === filter)
  }, [data, filter])

  // Get root modules (depth 0 or not imported by anything in userland)
  const rootModules = useMemo(() => {
    if (!data) return []
    const importedModules = new Set<string>()
    for (const m of filteredModules) {
      if (m.type === 'userland') {
        for (const imp of m.imports) {
          importedModules.add(imp)
        }
      }
    }
    // Root modules are userland modules that aren't imported by other userland modules
    return filteredModules.filter(
      (m) => m.type === 'userland' && !importedModules.has(m.source)
    )
  }, [data, filteredModules])

  // External packages shown separately
  const externalModules = useMemo(() => {
    if (filter === 'userland') return []
    if (!data) return []
    return data.modules.filter((m) => m.type === 'external')
  }, [data, filter])

  if (loading) {
    return (
      <div className="module-graph-container">
        <div className="module-graph-loading">
          Loading module graph for {route || 'unknown route'}...
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
        <div className="module-graph-summary">
          <span>{data.summary.userlandModules} files</span>
          <span>{data.summary.externalPackages} packages</span>
          <span>{formatBytes(data.summary.totalSize)}</span>
        </div>
      </div>

      <div className="module-graph-filters">
        <button
          className={`module-graph-filter ${filter === 'all' ? 'active' : ''}`}
          onClick={() => setFilter('all')}
        >
          All
        </button>
        <button
          className={`module-graph-filter ${filter === 'userland' ? 'active' : ''}`}
          onClick={() => setFilter('userland')}
        >
          Files
        </button>
        <button
          className={`module-graph-filter ${filter === 'external' ? 'active' : ''}`}
          onClick={() => setFilter('external')}
        >
          Packages
        </button>
      </div>

      <div className="module-graph-content">
        {filter !== 'external' && rootModules.length > 0 && (
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

        {filter !== 'userland' && externalModules.length > 0 && (
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
