import { inspect } from "node:util";

const REDACTED = "[REDACTED]";

/**
 * Wraps a secret value so it cannot leak through string conversion, JSON or
 * `util.inspect`. Only `reveal()` returns the value; call it at the point of use.
 */
export class Secret<T = string> {
	readonly #value: T;

	constructor(value: T) {
		this.#value = value;
	}

	reveal(): T {
		return this.#value;
	}

	toString(): string {
		return REDACTED;
	}

	toJSON(): string {
		return REDACTED;
	}

	[inspect.custom](): string {
		return REDACTED;
	}
}
