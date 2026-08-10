declare module "qrcode-terminal" {
  const qrterm: {
    generate: (input: string, opts?: { small?: boolean }, cb?: (qr: string) => void) => void;
  };
  export default qrterm;
}
