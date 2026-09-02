import { Logger, LogLevel, type Layer } from 'effect'

/**
 * Plain-text logger for CLI output.
 *
 * Effect's default logger prefixes messages with timestamps and levels, which
 * is noise for a GitHub Action's run log. This logger prints just the message:
 * info and below go to stdout, warnings and errors to stderr, matching the
 * console.log/console.error split the CLI has always had.
 */
const plainLogger = Logger.make((options: Logger.Options<unknown>) => {
	const parts = Array.isArray(options.message)
		? options.message.map(String)
		: [String(options.message)]
	const line = parts.join(' ')
	if (LogLevel.isGreaterThanOrEqualTo(options.logLevel, 'Warn')) {
		console.error(line)
	} else {
		console.log(line)
	}
})

export const plainLoggerLayer: Layer.Layer<never> = Logger.layer([plainLogger])
