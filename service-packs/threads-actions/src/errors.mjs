export class ThreadsError extends Error{constructor(code,detail){super(code);this.code=code;if(detail!==undefined)this.detail=detail;}}
