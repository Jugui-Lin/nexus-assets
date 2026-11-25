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
