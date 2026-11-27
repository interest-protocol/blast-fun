export type HintSink = Readonly<{
  send(chunk: Uint8Array): boolean;
  close(): void;
}>;
