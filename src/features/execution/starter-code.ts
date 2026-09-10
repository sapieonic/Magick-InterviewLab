/**
 * The code a candidate sees before they type anything.
 *
 * Starter code is documentation that cannot be skipped. The single biggest
 * source of "the platform is broken" reports on a stdin/stdout judge is a
 * candidate who solved the problem correctly and then `return`ed the answer
 * instead of printing it — so the template demonstrates reading input and
 * printing output, and says in three lines which channel is graded.
 *
 * Keep these short. A long template gets deleted wholesale, taking the
 * documentation with it.
 */

import type { Language } from './types';

const JAVASCRIPT_STARTER = `// Programs read stdin and write stdout. Only stdout is graded.
//   readLine()  -> the next line of input, or null when there is none left
//   readAll()   -> the whole of stdin as one string
//   input()     -> alias for readLine()
// console.error(...) goes to stderr and is never graded - use it to debug.

function solve(line) {
  // TODO: your solution here
  return line;
}

let line;
while ((line = readLine()) !== null) {
  console.log(solve(line));
}
`;

const PYTHON_STARTER = `# Programs read stdin and write stdout. Only stdout is graded.
#   input()           -> the next line of input (raises EOFError at the end)
#   sys.stdin.read()  -> the whole of stdin as one string
# print(..., file=sys.stderr) goes to stderr and is never graded - use it to debug.
import sys


def solve(line: str) -> str:
    # TODO: your solution here
    return line


for line in sys.stdin:
    print(solve(line.rstrip("\\n")))
`;

export function defaultStarterCode(language: Language): string {
  return language === 'python' ? PYTHON_STARTER : JAVASCRIPT_STARTER;
}
