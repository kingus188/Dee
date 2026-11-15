/** Explicitly selected result files, separate from transcript synchronization. */
export type PeerArtifact = {
  id: string; taskId: string; deviceId: string; name: string; mimeType: string;
  size: number; sha256: string; createdAt: string; status: "available";
};
export type PeerArtifactUpload = Omit<PeerArtifact, "createdAt" | "status"> & { data: string };
