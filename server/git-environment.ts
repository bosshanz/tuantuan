export const gitEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  LC_ALL: "C",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
};
// Never allow the surrounding process to redirect Git to an unrelated repository or index.
for (const key of Object.keys(gitEnvironment)) {
  if (
    /^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_PARAMETERS|CONFIG_COUNT)$/.test(
      key,
    ) ||
    /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)
  )
    delete gitEnvironment[key];
}
