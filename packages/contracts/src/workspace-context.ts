declare const verifiedWorkspaceIdBrand: unique symbol;

/**
 * Workspace ID minted only after an authenticated membership check.
 * This is a compile-time boundary; database RLS remains the enforcement layer.
 */
export type VerifiedWorkspaceId = string & {
  readonly [verifiedWorkspaceIdBrand]: true;
};
