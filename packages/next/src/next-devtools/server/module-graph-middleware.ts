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

/**
 * Bundle size thresholds (in bytes)
 * Based on Webpack's default 244 KiB recommendation
 * See: https://stackoverflow.com/questions/49348365/webpack-4-size-exceeds-the-recommended-limit-244-kib
 */
const SIZE_THRESHOLDS = {
  /** Individual package warning threshold: 50 KB */
  PACKAGE_WARNING: 50 * 1024,
  /** Individual package large threshold: 100 KB */
  PACKAGE_LARGE: 100 * 1024,
  /** Total bundle warning threshold: 250 KB (similar to Webpack's 244 KiB) */
  TOTAL_WARNING: 250 * 1024,
  /** Total bundle large threshold: 500 KB */
  TOTAL_LARGE: 500 * 1024,
}

/** Size status indicator */
type SizeStatus = 'normal' | 'warning' | 'large'

/** Module in the output */
interface ModuleGraphModule {
  /** Source file path */
  source: string
  /** Module type */
  type: 'userland' | 'external'
  /** Size in bytes */
  size: number
  /** Size status for highlighting */
  sizeStatus?: SizeStatus
  /** Minimum depth from entry */
  depth: number
  /** Layer from module ident (e.g., 'rsc', 'client', 'ssr', 'action-browser') */
  layer: string | null
  /** Dependencies */
  imports: string[]
  /** Package version (for external modules) */
  version?: string
  /** Debug: raw ident */
  ident?: string
}

/**
 * Get size status based on thresholds
 */
function getSizeStatus(size: number, isTotal: boolean = false): SizeStatus {
  const warningThreshold = isTotal
    ? SIZE_THRESHOLDS.TOTAL_WARNING
    : SIZE_THRESHOLDS.PACKAGE_WARNING
  const largeThreshold = isTotal
    ? SIZE_THRESHOLDS.TOTAL_LARGE
    : SIZE_THRESHOLDS.PACKAGE_LARGE

  if (size >= largeThreshold) return 'large'
  if (size >= warningThreshold) return 'warning'
  return 'normal'
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

/** Duplicate package info */
interface DuplicatePackage {
  /** Base package name (without version) */
  name: string
  /** All versions found */
  versions: string[]
}

interface ModuleGraphResult {
  route: string
  routeType: string
  summary: {
    totalModules: number
    userlandModules: number
    externalPackages: number
    totalSize: number
    totalSizeStatus: SizeStatus
  }
  modules: ModuleGraphModule[]
  /** Packages with multiple versions */
  duplicates: DuplicatePackage[]
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
 * Extract package name and version from node_modules path
 */
function getPackageInfo(modulePath: string): {
  name: string
  version?: string
} | null {
  // Handle pnpm's nested structure
  // e.g., node_modules/.pnpm/uuid@9.0.0/node_modules/uuid
  // e.g., node_modules/.pnpm/@babel+core@7.20.0/node_modules/@babel/core
  const pnpmMatch = modulePath.match(
    /node_modules\/\.pnpm\/([^/]+)\/node_modules\/(@[^/]+\/[^/]+|[^/]+)/
  )
  if (pnpmMatch) {
    const pnpmPart = pnpmMatch[1]
    const packageName = pnpmMatch[2]

    // Extract version from pnpm part (e.g., "uuid@9.0.0" or "@babel+core@7.20.0")
    // For scoped packages, pnpm uses + instead of /
    let version: string | undefined
    const versionMatch = pnpmPart.match(/@(\d+\.\d+\.\d+[^_/]*)/)
    if (versionMatch) {
      version = versionMatch[1]
    }

    return { name: packageName, version }
  }

  // Standard node_modules
  const nodeModulesMatch = modulePath.match(
    /node_modules\/(@[^/]+\/[^/]+|[^/]+)/
  )
  if (!nodeModulesMatch) return null

  const packageName = nodeModulesMatch[1]
  if (packageName === '.pnpm') return null

  return { name: packageName }
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
      version?: string
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
    let version: string | undefined
    if (moduleType === 'external') {
      const packageInfo = getPackageInfo(module.path)
      const packageName = packageInfo?.name || module.path
      version = packageInfo?.version
      // Include version in displayPath to keep different versions separate
      displayPath = version ? `${packageName}@${version}` : packageName
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
      // Keep version if not set
      if (version && !existing.version) {
        existing.version = version
      }
    } else {
      moduleMap.set(displayPath, {
        type: moduleType,
        size: module.size,
        depth: module.depth,
        layer: moduleLayer,
        imports: new Set(),
        version,
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
 * Calculate total size of a package including all its transitive dependencies
 */
function calculatePackageTotalSize(
  packagePath: string,
  moduleMap: Map<
    string,
    {
      type: 'userland' | 'external'
      size: number
      depth: number
      layer: string | null
      imports: Set<string>
      version?: string
      ident: string
    }
  >,
  visited: Set<string> = new Set()
): number {
  if (visited.has(packagePath)) return 0
  visited.add(packagePath)

  const module = moduleMap.get(packagePath)
  if (!module) return 0

  let totalSize = module.size

  // Add sizes of all external dependencies (transitive deps)
  for (const importPath of module.imports) {
    const importedModule = moduleMap.get(importPath)
    if (importedModule && importedModule.type === 'external') {
      totalSize += calculatePackageTotalSize(importPath, moduleMap, visited)
    }
  }

  return totalSize
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
      version?: string
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

  // Find root external packages (directly imported by userland modules)
  const rootExternalPackages = new Set<string>()
  for (const [, data] of moduleMap) {
    if (data.type === 'userland') {
      for (const importPath of data.imports) {
        const importedModule = moduleMap.get(importPath)
        if (importedModule && importedModule.type === 'external') {
          rootExternalPackages.add(importPath)
        }
      }
    }
  }

  // Convert to output format
  const modules: ModuleGraphModule[] = []
  let userlandCount = 0
  let externalCount = 0

  for (const [source, data] of moduleMap) {
    // For external packages, only include root packages (directly imported by userland)
    if (data.type === 'external') {
      if (!rootExternalPackages.has(source)) continue

      // Calculate total size including transitive dependencies
      const totalSize = calculatePackageTotalSize(source, moduleMap)
      externalCount++

      modules.push({
        source,
        type: data.type,
        size: totalSize,
        sizeStatus: getSizeStatus(totalSize),
        depth: data.depth,
        layer: data.layer,
        imports: [], // Don't expose transitive deps
        version: data.version,
        ident: data.ident,
      })
    } else {
      userlandCount++
      modules.push({
        source,
        type: data.type,
        size: data.size,
        sizeStatus: getSizeStatus(data.size),
        depth: data.depth,
        layer: data.layer,
        imports: Array.from(data.imports),
        version: data.version,
        ident: data.ident,
      })
    }
  }

  // Sort: userland first by depth, then external by size
  modules.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'userland' ? -1 : 1
    }
    if (a.type === 'userland') return a.depth - b.depth
    return b.size - a.size
  })

  const totalSize = modules.reduce((acc, m) => acc + m.size, 0)

  // Detect duplicate packages (same name, different versions)
  const packageVersions = new Map<string, string[]>()
  for (const module of modules) {
    if (module.type === 'external') {
      // Extract base package name from source (e.g., "uuid@9.0.0" -> "uuid")
      const atIndex = module.source.lastIndexOf('@')
      if (atIndex > 0) {
        const baseName = module.source.slice(0, atIndex)
        const version = module.source.slice(atIndex + 1)
        const versions = packageVersions.get(baseName) || []
        versions.push(version)
        packageVersions.set(baseName, versions)
      }
    }
  }

  // Filter to only packages with multiple versions
  const duplicates: DuplicatePackage[] = []
  for (const [name, versions] of packageVersions) {
    if (versions.length > 1) {
      duplicates.push({ name, versions: versions.sort() })
    }
  }

  return {
    route,
    routeType,
    summary: {
      totalModules: modules.length,
      userlandModules: userlandCount,
      externalPackages: externalCount,
      totalSize,
      totalSizeStatus: getSizeStatus(totalSize, true),
    },
    modules,
    duplicates,
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
