declare module 'sns-validator' {
    interface ValidatorOptions {
        encoding?: string;
        /** Regex the SigningCertURL must match. Defaults to the AWS SNS
         *  cert host pattern; we pass an explicit one for clarity. */
        signatureVersion?: string;
    }

    type SnsMessage = Record<string, unknown>;

    class MessageValidator {
        constructor(hostPattern?: RegExp, encoding?: string);
        validate(
            message: SnsMessage,
            cb: (err: Error | null, message: SnsMessage) => void,
        ): void;
    }

    export = MessageValidator;
}
