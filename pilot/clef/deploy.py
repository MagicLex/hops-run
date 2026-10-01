"""Create or update the Clef-Flash deployment that answers Hops Run moves as SystemOne requests.

Needs the model in the registry (Cloudflare/clef-flash imported from HuggingFace) and an inference
environment with requirements.txt installed. Reads HOPSWORKS_HOST, HOPSWORKS_API_KEY and
HOPSWORKS_PROJECT (hopsworks.login defaults):

    python pilot/clef/deploy.py [--model clef_flash] [--name clef]
"""

import argparse
import pathlib

import hopsworks
from hsml.resources import PredictorResources, Resources

HERE = pathlib.Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model", default="clef_flash", help="Model registry name")
    parser.add_argument("--model-version", type=int, default=None, help="Model version; latest when omitted")
    parser.add_argument("--name", default="clef", help="Deployment name")
    parser.add_argument("--env", default="clef-inference", help="Inference environment")
    parser.add_argument("--cores", type=int, default=4, help="CPU cores requested and limited")
    parser.add_argument("--memory", type=int, default=32768, help="Memory limit in MB")
    parser.add_argument("--gpus", type=int, default=1, help="GPUs per instance")
    args = parser.parse_args()

    project = hopsworks.login()
    model = project.get_model_registry().get_model(args.model, version=args.model_version)
    ms = project.get_model_serving()
    script = project.get_dataset_api().upload(str(HERE / "predictor.py"), f"Resources/{args.name}", overwrite=True)

    existing = ms.get_deployment(args.name)
    if existing is not None:
        existing.delete(force=True)

    deployment = model.deploy(
        name=args.name,
        description="Cloudflare Clef-Flash answering Hops Run moves as SystemOne requests",
        script_file=script,
        environment=args.env,
        resources=PredictorResources(
            num_instances=1,
            requests=Resources(cores=args.cores, memory=args.memory // 2, gpus=args.gpus),
            limits=Resources(cores=args.cores, memory=args.memory, gpus=args.gpus),
        ),
        default_predictor=False,
    )
    deployment.start(await_running=1200)
    print(deployment.name, deployment.get_state().status, deployment.get_inference_url())


if __name__ == "__main__":
    main()
