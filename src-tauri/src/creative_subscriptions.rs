use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatorInput {
    pub url: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub detected_name: String,
    #[serde(default)]
    pub feed: String,
    #[serde(default)]
    pub avatar_url: String,
    #[serde(default)]
    pub bio: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CreatorSubscription {
    pub id: String,
    pub revision: u64,
    #[serde(flatten)]
    pub creator: CreatorInput,
}

#[derive(Deserialize, Serialize)]
pub struct CreatorSubscriptions {
    pub available: bool,
    pub subscriptions: Vec<CreatorSubscription>,
}

#[derive(Deserialize, Serialize)]
pub struct CreatorCreated {
    pub subscription: CreatorSubscription,
    pub created: bool,
}

#[derive(Deserialize, Serialize)]
pub struct CreatorUpdated {
    pub subscription: CreatorSubscription,
}

#[derive(Deserialize, Serialize)]
pub struct CreatorRemoved {
    pub removed: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateCreatorSubscription {
    pub revision: u64,
    pub subscription: CreatorInput,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RemoveCreatorSubscription {
    pub revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoReferenceInput {
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub cover_url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct VideoReference {
    pub key: String,
    pub revision: u64,
    #[serde(flatten)]
    pub reference: VideoReferenceInput,
}

#[derive(Deserialize, Serialize)]
pub struct VideoReferences {
    pub available: bool,
    pub references: Vec<VideoReference>,
    pub revision: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SaveVideoReference {
    pub reference: VideoReferenceInput,
    #[serde(default)]
    pub migration: bool,
    #[serde(default)]
    pub revision: Option<u64>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RemoveVideoReference {
    pub url: String,
    pub revision: u64,
}
