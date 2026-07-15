declare module "busboy" {
  import type { Readable, Writable } from "node:stream";

  type BusboyConfig = {
    headers: Record<string, string>;
    limits?: {
      fieldNameSize?: number;
      fieldSize?: number;
      fields?: number;
      fileSize?: number;
      files?: number;
      parts?: number;
      headerPairs?: number;
    };
  };

  type FileInfo = {
    filename: string;
    encoding: string;
    mimeType: string;
  };

  type FieldInfo = {
    nameTruncated: boolean;
    valueTruncated: boolean;
    encoding: string;
    mimeType: string;
  };

  interface Busboy extends Writable {
    on(event: "file", listener: (name: string, stream: Readable & { truncated?: boolean }, info: FileInfo) => void): this;
    on(event: "field", listener: (name: string, value: string, info: FieldInfo) => void): this;
    on(event: "filesLimit" | "fieldsLimit" | "partsLimit", listener: () => void): this;
  }

  function busboy(config: BusboyConfig): Busboy;
  export = busboy;
}
