import type { ServerResponse } from '@/lib/api';
import type { ServerLocation } from '@/types/vpn';

// Transform backend response to frontend ServerLocation type.
//
// An organization member's named Dedicated IP ("gateway") arrives as an entry whose `id` is still
// the node's real server id, with gatewayId/gatewayName set. The shared node and each gateway on
// it appear as separate rows, so a gateway entry gets a composite list id
// ("<serverId>_gw<gatewayId>"); the real id is kept in apiServerId for /vpn/connect.
export function transformServer(server: ServerResponse): ServerLocation {
  const isGateway = server.gatewayId !== undefined && server.gatewayId !== null;
  return {
    id: isGateway ? `${server.id}_gw${server.gatewayId}` : server.id,
    state: server.state,
    stateCode: server.stateCode,
    city: server.city,
    latitude: server.latitude ?? 0,
    longitude: server.longitude ?? 0,
    latency: server.latency,
    load: server.load,
    recommended: server.isRecommended,
    host: server.host,
    gatewayId: isGateway ? (server.gatewayId as number) : undefined,
    gatewayName: isGateway ? (server.gatewayName ?? undefined) : undefined,
    apiServerId: isGateway ? server.id : undefined,
  };
}

/** The list id a saved (server id, gateway id) pair corresponds to. */
export function listIdFor(serverId: string, gatewayId?: number | null): string {
  return gatewayId ? `${serverId}_gw${gatewayId}` : serverId;
}
