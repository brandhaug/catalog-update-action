import { BunChildProcessSpawner, BunServices } from '@effect/platform-bun'
import { Context, Effect, Layer, Stream } from 'effect'
import { type PlatformError } from 'effect/PlatformError'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Collected result of a finished command, whether or not it exited cleanly.
 * Module-local: consumers reach it through the Commands service interface.
 */
type CommandResult = {
	stdout: string
	stderr: string
	exitCode: number
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Join a child process output stream into a single string. */
const collectText = Effect.fnUntraced(function* (
	stream: Stream.Stream<Uint8Array, PlatformError>
) {
	const lines = yield* Stream.runCollect(Stream.decodeText(stream))
	return lines.join('')
})

/**
 * Runs external commands (git, gh, package manager installs and audits).
 *
 * The service is silent by design: a non-zero exit is data, not a failure.
 * Workflows decide whether a given exit code is expected and log accordingly —
 * audits legitimately exit non-zero when vulnerabilities are found. Spawn
 * failures (missing binary, unwritable cwd) are defects: there is no exit
 * code to branch on, so they crash the run rather than masquerade as data.
 */
export class Commands extends Context.Service<
	Commands,
	{
		exec(
			command: Array<string>,
			options: { readonly cwd: string }
		): Effect.Effect<CommandResult>
	}
>()('catalog-update/Commands') {
	static readonly layer = Layer.effect(
		Commands,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

			const exec = Effect.fn('Commands.exec')(function* (
				command: Array<string>,
				options: { readonly cwd: string }
			) {
				const program = command.at(0)
				if (program === undefined) {
					return yield* Effect.die('Commands.exec: empty command')
				}

				return yield* Effect.scoped(
					Effect.gen(function* () {
						const handle = yield* spawner.spawn(
							ChildProcess.make(program, command.slice(1), {
								cwd: options.cwd,
								extendEnv: true
							})
						)
						const [stdout, stderr, exitCode] = yield* Effect.all([
							collectText(handle.stdout),
							collectText(handle.stderr),
							handle.exitCode
						])

						return {
							stdout: stdout.trim(),
							stderr: stderr.trim(),
							exitCode
						}
					})
				).pipe(
					// A spawn failure (missing binary, unwritable cwd) is a defect, not
					// a workflow failure: there is no meaningful exit code to branch
					// on. It surfaces as a fatal error at the top-level boundary,
					// exactly like the unhandled Bun.spawn throw this replaced —
					// which is why exec's error channel is empty by contract.
					Effect.orDie
				)
			})

			return Commands.of({ exec })
		})
	).pipe(
		// The spawner and the path/file services it resolves cwd with are
		// implementation details of this adapter; consumers only ever see the
		// Commands service.
		Layer.provide(BunChildProcessSpawner.layer),
		Layer.provide(BunServices.layer)
	)
}
