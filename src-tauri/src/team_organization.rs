use crate::AssetCollection;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Organization {
    pub available: bool,
    pub revision: u64,
    pub favorite_ids: Vec<String>,
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
pub struct FavoriteChanged {
    pub favorite: bool,
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
