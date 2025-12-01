import type { IncomingMessage, ServerResponse } from 'http'
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
  /** Layers this module appears in */
  layers: string[]
  /** Dependencies */
  imports: string[]
}

interface ModuleGraphResult {
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
 */
function getUserlandPath(modulePath: string, projectPath: string): string {
  let cleanPath = modulePath
    .replace(/^\[project\]\//, '')
    .replace(projectPath, '')
    .replace(/^\//, '')

  cleanPath = cleanPath.split('?')[0].split('#')[0]
  return cleanPath
}

/**
 * Process a module graph from a layer
 */
function processGraphLayer(
  graph: ModuleGraphSnapshot,
  layer: string,
  projectPath: string,
  moduleMap: Map<
    string,
    {
      type: 'userland' | 'external'
      size: number
      depth: number
      layers: Set<string>
      imports: Set<string>
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
      displayPath = getUserlandPath(module.path, projectPath)
    }

    indexToPath.set(i, displayPath)

    const existing = moduleMap.get(displayPath)
    if (existing) {
      existing.size = Math.max(existing.size, module.size)
      existing.depth = Math.min(existing.depth, module.depth)
      existing.layers.add(layer)
    } else {
      moduleMap.set(displayPath, {
        type: moduleType,
        size: module.size,
        depth: module.depth,
        layers: new Set([layer]),
        imports: new Set(),
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
  projectPath: string
): Promise<ModuleGraphResult> {
  const moduleMap = new Map<
    string,
    {
      type: 'userland' | 'external'
      size: number
      depth: number
      layers: Set<string>
      imports: Set<string>
    }
  >()
  const processedLayers: string[] = []
  const indexToPath = new Map<number, string>()

  for (const { layer, endpoint } of endpoints) {
    if (typeof endpoint.getModuleGraph !== 'function') continue

    try {
      const result = await endpoint.getModuleGraph()
      const graph = result as ModuleGraphSnapshot
      if (graph && graph.modules) {
        processGraphLayer(graph, layer, projectPath, moduleMap, indexToPath)
        processedLayers.push(layer)
      }
    } catch {
      // Skip layers that fail
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
      layers: Array.from(data.layers),
      imports: Array.from(data.imports),
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
    layers: processedLayers,
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
        error: 'Turbopack is not available. Make sure you are running with --turbopack flag.',
      })
    }

    const entrypoints = getCurrentEntrypoints()
    if (!entrypoints) {
      return middlewareResponse.json(res, {
        error: 'Entrypoints are not yet available. The dev server may still be starting up.',
      })
    }

    // Collect endpoints for this route
    const endpoints: { layer: string; endpoint: Endpoint }[] = []
    let routeType = ''

    // Check App Router routes
    const appRoute = entrypoints.app.get(route)
    if (appRoute) {
      routeType = appRoute.type
      if (appRoute.type === 'app-page') {
        endpoints.push({
          layer: 'server (RSC)',
          endpoint: appRoute.rscEndpoint,
        })
        endpoints.push({
          layer: 'client (HTML)',
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
      const result = await buildModuleGraph(
        route,
        routeType,
        endpoints,
        projectPath
      )
      return middlewareResponse.json(res, result)
    } catch (error) {
      return middlewareResponse.internalServerError(res, error)
    }
  }
}
