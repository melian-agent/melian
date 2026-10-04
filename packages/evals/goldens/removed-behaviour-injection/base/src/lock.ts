/** A lock one job holds at a time. A job that never releases it holds it until the process exits. */
export class Lock {
	private held = false;
	private readonly waiting: (() => void)[] = [];

	async acquire(): Promise<void> {
		if (!this.held) {
			this.held = true;
			return;
		}
		await new Promise<void>((resolve) => this.waiting.push(resolve));
	}

	release(): void {
		const next = this.waiting.shift();
		if (next === undefined) this.held = false;
		else next();
	}
}
