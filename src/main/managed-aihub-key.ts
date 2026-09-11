/** Remove the retired key, including when an older bundled runtime is present. */
export function mergeBundledAihubKey(
  existingEnv: string,
  _bundledEnv: string,
): string {
  return existingEnv.replace(
    /^[\t ]*(?:export[\t ]+)?AIHUB_API_KEY[\t ]*=.*(?:\r?\n|$)/gm,
    "",
  );
}
