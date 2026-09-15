// Rendezvous helpers that are not part of a session: online-state queries for
// the peer list (src/rendezvous_mediator.rs query_online_states).
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { OnlineRequestSchema, RendezvousMessageSchema } from "./proto/rendezvous_pb";
import { buildWsUrlCandidates, connectFirst, pageIsHttps } from "./transport/ws";
import { apiServer, myId, rendezvousServer } from "./config";

export interface OnlineStates {
  onlines: string[];
  offlines: string[];
}

export async function queryOnlines(ids: string[]): Promise<OnlineStates> {
  if (ids.length === 0) return { onlines: [], offlines: [] };
  const host = rendezvousServer();
  if (!host) return { onlines: [], offlines: ids };
  const secure = pageIsHttps() || apiServer().toLowerCase().startsWith("https");
  const ws = await connectFirst(buildWsUrlCandidates(host, "id", { secure }), 10_000);
  try {
    const msg = create(RendezvousMessageSchema, {});
    msg.union = { case: "onlineRequest", value: create(OnlineRequestSchema, { id: myId(), peers: ids }) };
    ws.send(toBinary(RendezvousMessageSchema, msg));
    const raw = await ws.next(10_000);
    const resp = fromBinary(RendezvousMessageSchema, raw);
    if (resp.union.case !== "onlineResponse") return { onlines: [], offlines: ids };
    const states = resp.union.value.states;
    const onlines: string[] = [];
    const offlines: string[] = [];
    // src/client.rs: bit_value = 0x01 << (7 - i % 8), i.e. MSB first per byte.
    ids.forEach((id, i) => {
      const byte = states[i >> 3] ?? 0;
      if (byte & (1 << (7 - (i & 7)))) onlines.push(id);
      else offlines.push(id);
    });
    return { onlines, offlines };
  } finally {
    ws.close();
  }
}
