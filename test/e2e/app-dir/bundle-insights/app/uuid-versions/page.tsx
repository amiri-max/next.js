// 'use client'

import { v4 as uuidv4New } from 'uuid'
import { v4 as uuidv4Old } from 'uuid8'

export default function Page() {
  const newUuid = uuidv4New()
  const oldUuid = uuidv4Old()

  return (
    <div>
      <p id="new-uuid">New UUID (v9): {newUuid}</p>
      <p id="old-uuid">Old UUID (v8): {oldUuid}</p>
    </div>
  )
}
