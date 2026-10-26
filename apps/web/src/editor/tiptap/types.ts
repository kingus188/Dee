export interface MarkdownEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  disabled?: boolean;
  label: string;
  variant?: "default" | "document";
  imageFileReader?: (file: File) => Promise<string>;
  maxBytes?: number;
  onPendingChange?: (pending: boolean) => void;
}
