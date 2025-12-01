import type { IncomingMessage, ServerResponse } from 'http'
import { relative } from 'path'
import type {
  Project,
  Entrypoints,
  Endpoint,
  ModuleGraphSnapshot,
} from '../../build/swc/types'
import { middlewareResponse } from './middleware-response'

const MODULE_GRAPH_ENDPOINT = '/__nextjs_module_graph'

/** Module in the output */
interface ModuleGraphModule {
  /** Source file path */
  source: string
  /** Module type */
  type: 'userland' | 'external'
  /** Size in bytes */
  size: number
  /** Minimum depth from entry */
  depth: number
  /** Layer from module ident (e.g., 'rsc', 'client', 'ssr', 'action-browser') */
  layer: string | null
  /** Dependencies */
  imports: string[]
  /** Debug: raw ident */
  ident?: string
}

/**
 * Extract layer from module ident
 * Turbopack format: "[project]/app/page.tsx [app-edge-rsc] (ecmascript, Next.js Server Component)"
 * e.g., "[app-rsc]" -> "server"
 * e.g., "[app-client]" -> "client"
 * e.g., "[app-ssr]" -> "ssr"
 * e.g., "[app-edge-rsc]" -> "server"
 */
function extractLayerFromIdent(ident: string): string | null {
  // Find all [bracket] patterns in the ident, skip [project]
  const bracketMatches = ident.match(/\[([^\]]+)\]/g)
  if (bracketMatches) {
    for (const match of bracketMatches) {
      const layerPart = match.slice(1, -1).toLowerCase() // Remove [ and ]

      // Skip [project] and path-like brackets
      if (layerPart === 'project' || layerPart.includes('/')) continue

      // Extract the layer type from patterns like "app-rsc", "app-client", "app-edge-rsc"
      // SSR is server-side rendering of client components, so treat as client
      if (layerPart.includes('client')) return 'client'
      if (layerPart.includes('ssr')) return 'client'
      if (layerPart.includes('rsc')) return 'server'
      if (layerPart.includes('action')) return 'action'
    }
  }

  // Also check for description part like "(ecmascript, Next.js Server Component)"
  const lowerIdent = ident.toLowerCase()
  if (lowerIdent.includes('server component')) return 'server'
  if (
    lowerIdent.includes('client component') ||
    lowerIdent.includes('client entry')
  )
    return 'client'
  if (lowerIdent.includes('server action')) return 'action'

  return null
}

interface ModuleGraphResult {
  route: string
  routeType: string
  summary: {
    totalModules: number
    userlandModules: number
    externalPackages: number
    totalSize: number
  }
  modules: ModuleGraphModule[]
}

/**
 * Check if a module path is a Next.js internal module
 */
function isNextInternal(modulePath: string): boolean {
  const internalPatterns = [
    '/packages/next/',
    '/dist/compiled/',
    '/next/dist/',
    'next/dist/',
    '[turbopack]/',
    '[externals]/',
    'dist/esm/build/templates/',
    'dist/client/components/builtin/',
    'dist/server/route-modules/',
    'next-devtools/',
  ]
  const lowerPath = modulePath.toLowerCase()
  return internalPatterns.some((pattern) => lowerPath.includes(pattern))
}

/**
 * Extract package name from node_modules path
 */
function getPackageName(modulePath: string): string | null {
  // Handle pnpm's nested structure
  const pnpmMatch = modulePath.match(
    /node_modules\/\.pnpm\/[^/]+\/node_modules\/(@[^/]+\/[^/]+|[^/]+)/
  )
  if (pnpmMatch) {
    return pnpmMatch[1]
  }

  // Standard node_modules
  const nodeModulesMatch = modulePath.match(
    /node_modules\/(@[^/]+\/[^/]+|[^/]+)/
  )
  if (!nodeModulesMatch) return null

  const packageName = nodeModulesMatch[1]
  if (packageName === '.pnpm') return null

  return packageName
}

/**
 * Get module type from path
 */
function getModuleType(
  modulePath: string
): 'userland' | 'external' | 'internal' {
  if (isNextInternal(modulePath)) return 'internal'
  if (modulePath.includes('node_modules/')) return 'external'
  return 'userland'
}

/**
 * Get a clean display path for userland modules
 * Strips the prefix from cwd to project dir (e.g., test/e2e/app-dir/app/edge-wrapper.js -> app/edge-wrapper.js)
 */
function getUserlandPath(modulePath: string, projectPrefix: string): string {
  let cleanPath = modulePath.replace(/^\[project\]\//, '')

  // Strip the project prefix (path from cwd to project dir)
  if (projectPrefix && cleanPath.startsWith(projectPrefix)) {
    cleanPath = cleanPath.slice(projectPrefix.length)
  }

  cleanPath = cleanPath.split('?')[0].split('#')[0]
  return cleanPath
}

/**
 * Process a module graph from a layer
 */
function processGraphLayer(
  graph: ModuleGraphSnapshot,
  projectPrefix: string,
  moduleMap: Map<
    string,
    {
      type: 'userland' | 'external'
      size: number
      depth: number
      layer: string | null
      imports: Set<string>
      ident: string
    }
  >,
  indexToPath: Map<number, string>
): void {
  // First pass: create entries
  for (let i = 0; i < graph.modules.length; i++) {
    const module = graph.modules[i]
    const moduleType = getModuleType(module.path)

    if (moduleType === 'internal') continue

    let displayPath: string
    if (moduleType === 'external') {
      displayPath = getPackageName(module.path) || module.path
    } else {
      displayPath = getUserlandPath(module.path, projectPrefix)
    }

    indexToPath.set(i, displayPath)

    // Extract layer from module ident
    const moduleLayer = extractLayerFromIdent(module.ident)

    const existing = moduleMap.get(displayPath)
    if (existing) {
      existing.size = Math.max(existing.size, module.size)
      existing.depth = Math.min(existing.depth, module.depth)
      // Keep the more specific layer (prefer client/action over rsc)
      if (moduleLayer && moduleLayer !== 'rsc') {
        existing.layer = moduleLayer
      }
    } else {
      moduleMap.set(displayPath, {
        type: moduleType,
        size: module.size,
        depth: module.depth,
        layer: moduleLayer,
        imports: new Set(),
        ident: module.ident,
      })
    }
  }

  // Second pass: build relationships
  for (let i = 0; i < graph.modules.length; i++) {
    const module = graph.modules[i]
    const sourcePath = indexToPath.get(i)
    if (!sourcePath) continue

    const sourceEntry = moduleMap.get(sourcePath)
    if (!sourceEntry) continue

    for (const ref of module.references) {
      const targetPath = indexToPath.get(ref.index)
      if (targetPath && targetPath !== sourcePath) {
        sourceEntry.imports.add(targetPath)
      }
    }
  }
}

/**
 * Build module graph from endpoints
 */
async function buildModuleGraph(
  route: string,
  routeType: string,
  endpoints: { layer: string; endpoint: Endpoint }[],
  projectPrefix: string
): Promise<ModuleGraphResult> {
  const moduleMap = new Map<
    string,
    {
      type: 'userland' | 'external'
      size: number
      depth: number
      layer: string | null
      imports: Set<string>
      ident: string
    }
  >()
  const indexToPath = new Map<number, string>()

  for (const { endpoint } of endpoints) {
    if (typeof endpoint.getModuleGraph !== 'function') continue

    try {
      const result = await endpoint.getModuleGraph()
      const graph = result as ModuleGraphSnapshot
      if (graph && graph.modules) {
        processGraphLayer(graph, projectPrefix, moduleMap, indexToPath)
      }
    } catch {
      // Skip endpoints that fail
    }
  }

  // Convert to output format
  const modules: ModuleGraphModule[] = []
  let userlandCount = 0
  let externalCount = 0

  for (const [source, data] of moduleMap) {
    if (data.type === 'userland') userlandCount++
    else externalCount++

    modules.push({
      source,
      type: data.type,
      size: data.size,
      depth: data.depth,
      layer: data.layer,
      imports: Array.from(data.imports),
      ident: data.ident,
    })
  }

  // Sort: userland first by depth, then external by size
  modules.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'userland' ? -1 : 1
    }
    if (a.type === 'userland') return a.depth - b.depth
    return b.size - a.size
  })

  return {
    route,
    routeType,
    summary: {
      totalModules: modules.length,
      userlandModules: userlandCount,
      externalPackages: externalCount,
      totalSize: modules.reduce((acc, m) => acc + m.size, 0),
    },
    modules,
  }
}

export function moduleGraphMiddleware({
  projectPath,
  getTurbopackProject,
  getCurrentEntrypoints,
}: {
  projectPath: string
  getTurbopackProject: () => Project | undefined
  getCurrentEntrypoints: () => Entrypoints | undefined
}) {
  return async function moduleGraphMiddlewareHandler(
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void
  ): Promise<void> {
    const url = new URL(`http://n${req.url}`)
    const { pathname } = url

    if (pathname !== MODULE_GRAPH_ENDPOINT) {
      return next()
    }

    if (req.method !== 'GET') {
      return middlewareResponse.methodNotAllowed(res)
    }

    const route = url.searchParams.get('route')
    if (!route) {
      return middlewareResponse.badRequest(res, 'Missing route parameter')
    }

    const project = getTurbopackProject()
    if (!project) {
      return middlewareResponse.json(res, {
        error:
          'Turbopack is not available. Make sure you are running with --turbopack flag.',
      })
    }

    const entrypoints = getCurrentEntrypoints()
    if (!entrypoints) {
      return middlewareResponse.json(res, {
        error:
          'Entrypoints are not yet available. The dev server may still be starting up.',
      })
    }

    // Collect endpoints for this route
    const endpoints: { layer: string; endpoint: Endpoint }[] = []
    let routeType = ''
    let matchedRoute = route

    // Check App Router routes - try exact match first
    let appRoute = entrypoints.app.get(route)

    // If no exact match, search for a matching route (handles route groups)
    // Route groups like (group) are in the entrypoint path but not in the URL
    if (!appRoute) {
      // Extract the page part from the route (e.g., /dashboard/page -> dashboard, /page -> '')
      const pagePart = route.replace(/^\//, '').replace(/\/page$/, '')

      for (const [entryRoute, entryValue] of entrypoints.app.entries()) {
        // Skip non-page routes
        if (!entryRoute.endsWith('/page')) continue

        // Remove route groups from the entry route to compare
        // e.g., /(newroot)/dashboard/page -> /dashboard/page
        const normalizedEntry = entryRoute.replace(/\/\([^)]+\)/g, '')
        const entryPagePart = normalizedEntry
          .replace(/^\//, '')
          .replace(/\/page$/, '')

        if (entryPagePart === pagePart) {
          appRoute = entryValue
          matchedRoute = entryRoute
          break
        }
      }
    }

    if (appRoute) {
      routeType = appRoute.type
      if (appRoute.type === 'app-page') {
        endpoints.push({
          layer: 'server',
          endpoint: appRoute.rscEndpoint,
        })
        endpoints.push({
          layer: 'client',
          endpoint: appRoute.htmlEndpoint,
        })
      } else if (appRoute.type === 'app-route') {
        endpoints.push({ layer: 'server', endpoint: appRoute.endpoint })
      }
    }

    // Check Pages Router routes
    if (endpoints.length === 0) {
      const pageRoute = entrypoints.page.get(route)
      if (pageRoute) {
        routeType = pageRoute.type
        if (pageRoute.type === 'page') {
          endpoints.push({
            layer: 'server (HTML)',
            endpoint: pageRoute.htmlEndpoint,
          })
          endpoints.push({
            layer: 'client (Data)',
            endpoint: pageRoute.dataEndpoint,
          })
        } else if (pageRoute.type === 'page-api') {
          endpoints.push({ layer: 'server', endpoint: pageRoute.endpoint })
        }
      }
    }

    if (endpoints.length === 0) {
      return middlewareResponse.json(res, {
        error: `Route "${route}" not found`,
        availableRoutes: [
          ...Array.from(entrypoints.app.keys()).slice(0, 10),
          ...Array.from(entrypoints.page.keys()).slice(0, 10),
        ],
      })
    }

    try {
      // Calculate the prefix to strip: relative path from cwd to project dir
      // e.g., if cwd is /repo and projectPath is /repo/test/app, prefix is "test/app/"
      const projectPrefix = relative(process.cwd(), projectPath)
      const prefixToStrip = projectPrefix ? projectPrefix + '/' : ''

      const result = await buildModuleGraph(
        matchedRoute,
        routeType,
        endpoints,
        prefixToStrip
      )
      return middlewareResponse.json(res, result)
    } catch (error) {
      return middlewareResponse.internalServerError(res, error)
    }
  }
}
