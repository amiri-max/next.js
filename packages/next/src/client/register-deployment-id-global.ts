import { deploymentId } from '../shared/lib/deployment-id'
export * from '../shared/lib/deployment-id'
;(globalThis as any).NEXT_DEPLOYMENT_ID = deploymentId
