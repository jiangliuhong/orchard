/** Internal control flow: the runtime has persisted a pause, not failed. */
export class WorkflowSuspended extends Error {
  constructor() { super('Workflow suspended'); this.name = 'WorkflowSuspended'; }
}
