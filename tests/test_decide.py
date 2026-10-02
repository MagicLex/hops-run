"""Integration test against the live SemIf deployment.

Requires HOPSWORKS_HOST, HOPSWORKS_API_KEY and HOPSWORKS_PROJECT in the
environment. JEVWORKS_DEPLOYMENT overrides the deployment name (default semif4b).
"""

import math
import os

import hopsworks
import pytest

ROWS = [
    {
        "id": "locked-out",
        "state": (
            "A customer says a password reset succeeded, but every login attempt still "
            "returns 'account locked'. Two unlock emails were requested and neither arrived."
        ),
        "question": "Which team should handle this ticket?",
        "options": [
            {"id": "billing", "description": "Billing and refunds"},
            {"id": "account-access", "description": "Authentication, lockouts and account recovery"},
            {"id": "sales", "description": "New purchases and upgrades"},
        ],
    },
    {
        "id": "refund",
        "state": "I was charged twice for the same invoice this month and want the duplicate back.",
        "question": "Which team should handle this ticket?",
        "options": [
            {"id": "billing", "description": "Billing and refunds"},
            {"id": "account-access", "description": "Authentication, lockouts and account recovery"},
            {"id": "sales", "description": "New purchases and upgrades"},
        ],
    },
]
EXPECTED = {"locked-out": "account-access", "refund": "billing"}


@pytest.fixture(scope="module")
def deployment():
    project = hopsworks.login()
    name = os.environ.get("JEVWORKS_DEPLOYMENT", "semif4b")
    dep = project.get_model_serving().get_deployment(name)
    assert dep is not None, f"deployment {name} not found"
    assert dep.get_state().status == "Running", f"deployment {name} is {dep.get_state().status}"
    return dep


def test_decisions(deployment):
    results = deployment.predict(inputs=ROWS)["predictions"]
    assert [r["id"] for r in results] == [row["id"] for row in ROWS]
    for row, result in zip(ROWS, results):
        assert result["option_ids"] == [o["id"] for o in row["options"]]
        assert math.isclose(sum(result["probabilities"]), 1.0, rel_tol=1e-6)
        winner = result["option_ids"][result["probabilities"].index(max(result["probabilities"]))]
        assert winner == EXPECTED[row["id"]], result
        assert result["readout"].startswith("native full-vocabulary")


def test_rejects_malformed_row(deployment):
    with pytest.raises(Exception):
        deployment.predict(inputs=[{"id": "x", "state": "s", "question": "q", "options": [{"id": "only"}]}])
