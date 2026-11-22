// Generation (§9, #16, #30): the Application Strategy, the tailored resume and the answers to
// the posting's application questions. Reads the
// Candidate through `buildCandidateContext`, calls `LlmClient` by task, renders through
// Typst. Writes no tables and no Facts (ADR 0003): `pipeline` stores what it returns.

export {
	type AnsweredQuestions,
	type AnswerInput,
	type ApplicationAnswer,
	answerQuestions,
	type Escalation,
	type HuntCommitments,
	QUESTION_CLASSES,
	type QuestionClass,
} from "./lib/answers";
export { composeResume, formatDate } from "./lib/compose";
export { MAX_PAGES, type RenderedResume, renderResume } from "./lib/render";
export {
	type Bullet,
	type Claim,
	DEFAULT_TEMPLATE,
	type JobSnapshot,
	type ResumeDocument,
	type ResumeOutput,
	type Strategy,
	TEMPLATE_IDS,
	type TemplateId,
} from "./lib/types";
export {
	type GenerationInput,
	inputHash,
	type PlannedStrategy,
	planStrategy,
	type WrittenResume,
	writeResume,
} from "./lib/write";
