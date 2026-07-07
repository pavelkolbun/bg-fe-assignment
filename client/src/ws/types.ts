import type {
  AnyServerMessage,
  SnapshotMsg,
  BetAcceptedMsg,
  BetRejectedMsg,
  CashoutAcceptedMsg,
  CashoutRejectedMsg,
  ErrorMsg,
} from "@protocol";

export type FeedMessage = Exclude<
  AnyServerMessage,
  | SnapshotMsg
  | BetAcceptedMsg
  | BetRejectedMsg
  | CashoutAcceptedMsg
  | CashoutRejectedMsg
  | ErrorMsg
>;

export type ReplyMessage =
  | SnapshotMsg
  | BetAcceptedMsg
  | BetRejectedMsg
  | CashoutAcceptedMsg
  | CashoutRejectedMsg
  | ErrorMsg;