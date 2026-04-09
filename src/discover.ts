import { matchesAnyPattern } from "./utils";

/**
 * Discovers all directories containing a package.json with a `catalog` field.
 * Skips node_modules and directories matching exclude patterns.
 * Returns relative paths sorted alphabetically (e.g., [".", "apps/frontend", "packages/api"]).
 */
export async function discoverCatalogDirectories({
  cwd,
  excludePatterns,
}: {
  cwd: string;
  excludePatterns: string[];
}): Promise<string[]> {
  const glob = new Bun.Glob("**/package.json");
  const directories: string[] = [];

  for await (const path of glob.scan({ cwd, dot: false })) {
    // Skip node_modules and dotfile directories (e.g. .github, .devcontainer)
    if (path.includes("node_modules")) continue;
    if (path.split("/").some((segment) => segment.startsWith("."))) continue;

    const dir = path === "package.json" ? "." : path.replace(/\/package\.json$/, "");

    if (excludePatterns.length > 0 && matchesAnyPattern({ name: dir, patterns: excludePatterns })) {
      continue;
    }

    try {
      const packageJson = await Bun.file(`${cwd}/${path}`).json();
      if (
        packageJson.catalog &&
        typeof packageJson.catalog === "object" &&
        !Array.isArray(packageJson.catalog)
      ) {
        directories.push(dir);
      }
    } catch (error: unknown) {
      console.warn(`  Warning: could not read ${path}: ${String(error)}`);
    }
  }

  return directories.sort();
}
