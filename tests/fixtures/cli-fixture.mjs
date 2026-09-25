const [mode, value] = process.argv.slice(2);

if (mode === "ok") {
  process.stdout.write(JSON.stringify({ value }));
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
