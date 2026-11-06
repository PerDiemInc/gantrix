/** Each attempt is its own LangGraph thread, so a retry starts a fresh conversation. */
export const stepThreadId = (stepId: string, attempt: number) => `step-${stepId}-${attempt}`;
