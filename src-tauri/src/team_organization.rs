use crate::AssetCollection;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Organization {
    pub available: bool,
    pub revision: u64,
    pub favorite_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favorite_times: Option<BTreeMap<String, u64>>,
    pub collections: Vec<AssetCollection>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalOrganization {
    pub favorite_ids: Vec<String>,
    pub collections: Vec<AssetCollection>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FavoriteRequest {
    pub favorite: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteChanged {
    pub favorite: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favorite_at: Option<u64>,
    pub revision: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CollectionName {
    pub name: String,
}

#[derive(Deserialize, Serialize)]
pub struct CollectionRemoved {
    pub removed: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollectionMembership {
    pub asset_ids: Vec<String>,
    pub include: bool,
}
