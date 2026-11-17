import { util } from "@aws-appsync/utils";

export function request(ctx) {
    const message = {
        id: util.autoId(),
        from: "DemoSender",
        to: ctx.args.to,
        body: ctx.args.body,
        sentAt: util.time.nowISO8601()
    };

    return {
        payload: message
    };
}

export function response(ctx) {
    return ctx.result;
}
