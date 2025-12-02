'use client'

import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { dark } from 'react-syntax-highlighter/dist/esm/styles/prism'

const codeString = `function hello() {
  console.log('Hello, World!')
}
`

export default function Page() {
  return (
    <SyntaxHighlighter language="javascript" style={dark}>
      {codeString}
    </SyntaxHighlighter>
  )
}
