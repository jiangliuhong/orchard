const [mode, value] = process.argv.slice(2);

if (mode === "ok") {
  process.stdout.write(JSON.stringify({ value }));
} else if (mode === "stdin-echo") {
  // Reads the whole stdin payload and echoes it back; proves the controller pipes stdin.
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  process.stdout.write(data);
} else if (mode === "stdin-exit-early") {
  // Exits before reading stdin; the controller's stdin write hits EPIPE and must not crash.
  process.stderr.write("early exit before stdin\n");
  process.exit(9);
} else if (mode === "stderr") {
  process.stderr.write("warning from fixture\n");
  process.stdout.write("done\n");
} else if (mode === "fail") {
  process.stderr.write("fixture failed\n");
  process.exitCode = 7;
} else if (mode === "sleep") {
  setTimeout(() => process.stdout.write("finished\n"), Number(value ?? 5000));
} else if (mode === "spam") {
  process.stdout.write("x".repeat(Number(value ?? 2_000_000)));
} else {
  process.stderr.write(`unknown fixture mode: ${mode}\n`);
  process.exitCode = 2;
}
