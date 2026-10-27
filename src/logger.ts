import pino from 'pino'

export function createLogger(level: string, name: string) {
  return pino({
    level,
    name,
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: ['secret', '*.secret', 'secrets', '*.secrets', 'req.headers.authorization'],
  })
}

export type Logger = ReturnType<typeof createLogger>
