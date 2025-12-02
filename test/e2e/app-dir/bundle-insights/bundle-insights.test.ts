import { nextTestSetup } from 'e2e-utils'

describe('bundle-insights', () => {
  const { next } = nextTestSetup({
    files: __dirname,
    dependencies: {
      'react-syntax-highlighter': '^15.6.1',
      uuid: '^9.0.0',
      uuid8: 'npm:uuid@^8.3.2',
    },
  })

  it('should render home page', async () => {
    const $ = await next.render$('/')
    expect($('p').text()).toBe('hello world')
  })

  // Large dependency test case
  it('should render page with react-syntax-highlighter', async () => {
    const $ = await next.render$('/syntax-highlighter')
    expect($('pre').length).toBeGreaterThan(0)
  })

  // Duplicate package versions test case (uuid v8 and v9)
  it('should render page with multiple uuid versions', async () => {
    const $ = await next.render$('/uuid-versions')
    expect($('#new-uuid').text()).toContain('New UUID (v9):')
    expect($('#old-uuid').text()).toContain('Old UUID (v8):')
  })
})
