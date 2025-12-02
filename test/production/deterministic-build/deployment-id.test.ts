import { FileRef, NextInstance, nextTestSetup } from 'e2e-utils'
import path from 'path'
import { promisify } from 'util'

import globOrig from 'glob'
import { diff } from 'jest-diff'
const glob = promisify(globOrig)

// These are cosmetic files which aren't deployed.
const IGNORE = /trace|trace-build/

async function readFiles(next: NextInstance) {
  const files = (
    (await glob('**/*', {
      cwd: path.join(next.testDir, next.distDir),
      nodir: true,
    })) as string[]
  )
    .filter((f) => !IGNORE.test(f))
    .sort()

  return Promise.all(
    files.map(async (filePath) => {
      const content = next.readFileSync(path.join(next.distDir, filePath))
      return [filePath, content] as const
    })
  )
}

// TODO we need to fix these case
// - static/chunks client chunks are content hashed and contain the deployment id
const IGNORE_NAME = /^static\/chunks\//
const IGNORE_CONTENT = new RegExp(
  [
    // HTML and RSC files contain the deployment ID as a query param
    '.html',
    '.rsc',
    // These all contain content-hashed browser or edge chunk names
    'build-manifest.json',
    'page_client-reference-manifest.js',
    '_buildManifest.js',
    'middleware-build-manifest.js',
    // required-server-files.json contains the deployment ID, unclear whether this is a problem
    'required-server-files.json',
  ]
    .map((v) => v.replace(/\./g, '\\.').replace(/\//g, '\\/') + '$')
    .join('|')
)

// Webpack itself isn't deterministic
;(process.env.IS_TURBOPACK_TEST ? describe : describe.skip)(
  'deterministic build - changing deployment id',
  () => {
    const { next } = nextTestSetup({
      files: {
        app: new FileRef(path.join(__dirname, 'app')),
        pages: new FileRef(path.join(__dirname, 'pages')),
        // TODO generateBuildId isn't entirely representative of the real world
        'next.config.js': `module.exports = {
        generateBuildId: async () => 'default-build-id',
        // Enable these when debugging to get readable diffs
        experimental: {
          turbopackMinify: false,
          turbopackModuleIds: 'named',
          turbopackScopeHoisting: false,
        },
      }`,
      },
      skipStart: true,
    })

    it('should produce idential build outputs even when changing deployment id', async () => {
      // First build
      next.env['NEXT_DEPLOYMENT_ID'] = 'foo-dpl-id'
      await next.build()
      let run1 = await readFiles(next)

      // Second build
      next.env['NEXT_DEPLOYMENT_ID'] = 'bar-dpl-id'
      await next.build()
      let run2 = await readFiles(next)

      run1 = run1.filter(([f, _]) => !IGNORE_NAME.test(f))
      run2 = run2.filter(([f, _]) => !IGNORE_NAME.test(f))

      // Compare files names
      let run1FileNames = run1.map(([f, _]) => f)
      let run2FileNames = run2.map(([f, _]) => f)
      expect(run1FileNames).toEqual(run2FileNames)

      run1 = run1.filter(([f, _]) => !IGNORE_CONTENT.test(f))
      run2 = run2.filter(([f, _]) => !IGNORE_CONTENT.test(f))

      let run1Map = new Map(run1)
      let run2Map = new Map(run2)

      let errors = []
      for (const [fileName, content1] of run1Map) {
        const content2 = run2Map.get(fileName)
        if (content1 !== content2) {
          if (
            content1.includes('function getDeploymentId()') &&
            content1.includes('function getDeploymentId()')
          ) {
            // TODO this will be replaced with an implementation that doesn't inline at build time
            continue
          }

          if (
            fileName.startsWith('server/edge/chunks/') &&
            content1.includes('const nextConfig = {') &&
            content2.includes('const nextConfig = {')
          ) {
            // TODO https://github.com/vercel/next.js/pull/86630
            continue
          }

          errors.push(
            `File content mismatch for ${fileName}\n\n` +
              diff(content1, content2)
          )
        }
      }
      if (errors.length > 0) {
        throw new Error(errors.join('\n\n'))
      }
    })
  }
)
