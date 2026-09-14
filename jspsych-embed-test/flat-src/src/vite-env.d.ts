/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_SURVEY_URL?: string;
  readonly VITE_SUBMISSION_MODE?: "test" | "formal";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
