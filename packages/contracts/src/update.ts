/** Recipe update detected from marketplace check. */
export interface UpdateInfo {
  recipe_id: string;
  installed_version: number;
  available_version: number;
  changelog?: string;
  diff: {
    added_variables: string[];
    removed_variables: string[];
    added_vault_hints: string[];
    removed_vault_hints: string[];
  };
  detected_at: string;
}

/** Record of an applied update. Used for rollback window and cross-instance awareness. */
export interface UpdateRecord {
  recipe_id: string;
  from_version: number;
  to_version: number;
  applied_at: string;
  applied_on_instance: string;
  rollback_available_until: string;
}
